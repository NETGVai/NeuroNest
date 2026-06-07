/**
 * Context Condenser — LLM-based conversation history compression.
 *
 * When conversation history exceeds a threshold, older messages are
 * summarized into a concise summary while keeping recent messages intact.
 * Achieves ~2x reduction in per-turn API costs.
 */

import { computeInputTokenBudget, resolveBudgetInputs } from './token-budget.js';
import { getActiveContextLength } from './active-model.js';
import { sanitizeToolMessages, type ChatMessage as SanitizerMessage } from './tool-message-sanitizer.js';
import { recordDroppedMessages, type MetricsSink } from './tool-sanitizer-telemetry.js';

export interface CondenserConfig {
  maxMessages: number;    // Trigger condensation when exceeded (default: 20)
  keepRecent: number;     // Always keep this many recent messages (default: 6)
  keepFirst: number;      // Always keep first N messages (system prompt) (default: 2)
  enabled: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
}

export interface CondensedHistory {
  messages: ChatMessage[];
  wasTruncated: boolean;
  originalCount: number;
  condensedCount: number;
  summary?: string;
}

const DEFAULT_CONFIG: CondenserConfig = {
  maxMessages: 20,
  keepRecent: 6,
  keepFirst: 2,
  enabled: true,
};

/**
 * Rough token estimate for a message array (~4 chars per token), matching the
 * heuristic used elsewhere in the pipeline. Used by the adaptive condensation
 * path to compare the conversation's input footprint against the token budget.
 */
function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m && typeof m.content === 'string') chars += m.content.length;
  }
  return Math.ceil(chars / 4);
}

export class ContextCondenser {
  private config: CondenserConfig;
  /**
   * Optional Metrics_Sink for F3 sanitizer telemetry (Feature 3, Requirement
   * 22.3). Wired via {@link setMetricsSink}; null disables emission (the
   * recorder is still fail-soft and logs in that case). Backward compatible —
   * existing callers that never set a sink are unaffected.
   */
  private metricsSink: MetricsSink | null = null;
  /** Optional session id associated with sanitizer telemetry samples. */
  private sessionId: string | null = null;

  constructor(config?: Partial<CondenserConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Wire an optional Metrics_Sink (and session id) for F3 sanitizer telemetry.
   * When set, `condense()` records `tool_sanitizer.dropped_messages` whenever
   * the sanitizer removes one or more messages (Requirement 22.3).
   */
  setMetricsSink(sink: MetricsSink | null, sessionId: string | null = null): void {
    this.metricsSink = sink;
    this.sessionId = sessionId;
  }

  /**
   * Check if condensation is needed.
   *
   * Backward compatible: when neither `inputBudget` nor `activeProvider` is
   * supplied, the original message-count threshold (`maxMessages`) is used
   * unchanged. When budget context is supplied, the call site additionally
   * draws an adaptive input-token budget from the shared
   * Token_Budget_Calculator (Requirement 13.1) and triggers condensation once
   * the estimated input-token footprint exceeds that budget. The active
   * model's context window is resolved via the Active_Model_Resolver
   * (Requirement 13.2).
   *
   * @param messages       Conversation history to evaluate.
   * @param inputBudget    Optional persisted `inputBudget` setting. A positive
   *                       finite value is honored as an explicit override; any
   *                       other value maps to adaptive sizing.
   * @param activeProvider Optional active provider record used to resolve the
   *                       model's context length for adaptive sizing.
   */
  needsCondensation(
    messages: ChatMessage[],
    inputBudget?: number | null,
    activeProvider?: unknown,
  ): boolean {
    if (!this.config.enabled) return false;

    const countExceeded = messages.length > this.config.maxMessages;

    // Preserve existing behavior when no budget context is supplied.
    if (inputBudget === undefined && activeProvider === undefined) {
      return countExceeded;
    }

    // Adaptive path — draw the token budget from the shared calculator
    // (Req 13.1) using the active model's context length (Req 13.2).
    const { configured, explicit } = resolveBudgetInputs(inputBudget ?? null);
    const contextLength = getActiveContextLength(activeProvider);
    const budget = computeInputTokenBudget(configured, contextLength, explicit);

    return countExceeded || estimateMessageTokens(messages) > budget;
  }

  /**
   * Condense conversation history.
   * Keeps first N messages (system prompts) and last N messages (recent context).
   * Middle messages are summarized into a single system message.
   */
  async condense(messages: ChatMessage[], llmSummarize?: (text: string) => Promise<string>): Promise<CondensedHistory> {
    if (!this.needsCondensation(messages)) {
      const result: CondensedHistory = {
        messages,
        wasTruncated: false,
        originalCount: messages.length,
        condensedCount: messages.length,
      };
      return this.sanitizeResult(result);
    }

    const first = messages.slice(0, this.config.keepFirst);
    const recent = messages.slice(-this.config.keepRecent);
    const middle = messages.slice(this.config.keepFirst, -this.config.keepRecent);

    // Build summary of middle messages
    let summary: string;
    if (llmSummarize && middle.length > 0) {
      const middleText = middle.map(m => `[${m.role}]: ${m.content.slice(0, 500)}`).join('\n');
      try {
        summary = await llmSummarize(
          `Summarize this conversation history concisely. Preserve key decisions, file paths, code changes, and important context:\n\n${middleText}`
        );
      } catch {
        // Fallback to extractive summary
        summary = this.extractiveSummary(middle);
      }
    } else {
      summary = this.extractiveSummary(middle);
    }

    const summaryMessage: ChatMessage = {
      role: 'system',
      content: `[Conversation Summary — ${middle.length} messages condensed]\n${summary}`,
      timestamp: Date.now(),
    };

    const condensed = [...first, summaryMessage, ...recent];

    const result: CondensedHistory = {
      messages: condensed,
      wasTruncated: true,
      originalCount: messages.length,
      condensedCount: condensed.length,
      summary,
    };

    return this.sanitizeResult(result);
  }

  /**
   * Run the Tool_Message_Sanitizer over a condensed history's message array
   * before it is returned (Requirement 21: each integration site invokes the
   * Sanitizer on its compressed message array prior to returning). The local
   * `ChatMessage` shape is structurally compatible with the sanitizer's
   * message envelope, and the sanitizer returns an order-preserving
   * subsequence of reference-equal elements, so the `CondensedHistory` shape
   * is preserved.
   */
  private sanitizeResult(result: CondensedHistory): CondensedHistory {
    const sanitized = sanitizeToolMessages(
      result.messages as unknown as SanitizerMessage[],
    ) as unknown as ChatMessage[];

    // F3 telemetry (Requirement 22.3): record the drop count when the
    // sanitizer removed one or more messages. Fail-soft — never affects the
    // returned CondensedHistory.
    recordDroppedMessages(
      this.metricsSink,
      result.messages.length - sanitized.length,
      this.sessionId,
    );

    return { ...result, messages: sanitized };
  }

  /**
   * Simple extractive summary (no LLM needed).
   * Extracts key information from messages.
   */
  private extractiveSummary(messages: ChatMessage[]): string {
    const points: string[] = [];
    const filesModified = new Set<string>();
    const commandsRun: string[] = [];
    const decisions: string[] = [];

    for (const msg of messages) {
      const content = msg.content;

      // Extract file paths
      const filePaths = content.match(/(?:[\w./]+\.(?:ts|js|py|json|md|css|html|tsx|jsx|go|rs|java|rb|cpp|c|h))/g);
      if (filePaths) filePaths.forEach(f => filesModified.add(f));

      // Extract commands
      const cmdMatch = content.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g);
      if (cmdMatch) cmdMatch.forEach(c => commandsRun.push(c.replace(/```\w*\n?/g, '').trim().slice(0, 100)));

      // Extract decisions (sentences with "decided", "chose", "will", "should")
      const sentences = content.split(/[.!?]+/).filter(s => s.length > 20 && s.length < 200);
      for (const s of sentences) {
        if (/\b(decided|chose|will|should|must|agreed|confirmed|approved)\b/i.test(s)) {
          decisions.push(s.trim());
        }
      }

      // Extract key user requests
      if (msg.role === 'user' && content.length > 10 && content.length < 300) {
        points.push(`User: ${content.slice(0, 150)}`);
      }
    }

    const parts: string[] = [];
    if (points.length > 0) parts.push('Key exchanges:\n' + points.slice(0, 5).map(p => `- ${p}`).join('\n'));
    if (filesModified.size > 0) parts.push('Files referenced: ' + Array.from(filesModified).slice(0, 10).join(', '));
    if (commandsRun.length > 0) parts.push('Commands run:\n' + commandsRun.slice(0, 5).map(c => `- ${c}`).join('\n'));
    if (decisions.length > 0) parts.push('Decisions:\n' + decisions.slice(0, 5).map(d => `- ${d}`).join('\n'));

    return parts.join('\n\n') || 'Previous conversation context (no key details extracted).';
  }

  getConfig(): CondenserConfig { return { ...this.config }; }
  setConfig(config: Partial<CondenserConfig>): void { Object.assign(this.config, config); }
}
