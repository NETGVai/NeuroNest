/**
 * Context Mentions Preprocessor — Pipeline hook that resolves @-mentions
 * in user messages before the LLM call.
 *
 * Integrates with the agent-loop pipeline by:
 * 1. Detecting @-mention tokens in the user message
 * 2. Resolving each mention to its content via MentionResolver
 * 3. Enforcing a combined token budget (configurable, default: 30% of context window)
 * 4. Replacing mention tokens with resolved content blocks injected into the message
 *
 * Feature-gated behind `context_mentions` flag.
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 *
 * Requirements: 14.3, 14.7
 */

import type { MentionResolutionResult, ResolvedMention } from '../context/mention-resolver.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default budget ratio — 30% of context window for mention content (Req 14.7) */
export const DEFAULT_MENTION_BUDGET_RATIO = 0.3;

/** Default context window size in tokens (used when model context is unknown) */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Delimiter used to wrap resolved mention content blocks */
export const MENTION_BLOCK_START = '--- [context-mention:';
export const MENTION_BLOCK_END = '--- [/context-mention] ---';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the mentions preprocessor */
export interface ContextMentionsConfig {
  /** Maximum budget ratio for mention content relative to context window (default: 0.3) */
  budgetRatio?: number;
  /** Total context window size in tokens (default: 128000) */
  contextWindowTokens?: number;
  /** Whether the feature is enabled */
  enabled: boolean;
}

/** Result of preprocessing a message with mentions */
export interface MentionsPreprocessResult {
  /** The transformed message with mentions replaced by resolved content */
  processedMessage: string;
  /** Whether any mentions were found and resolved */
  hasMentions: boolean;
  /** Number of mentions that were successfully resolved */
  resolvedCount: number;
  /** Number of mentions that were dropped due to budget constraints */
  droppedCount: number;
  /** Number of mentions that were blocked by the firewall */
  blockedCount: number;
  /** Total tokens used by resolved mention content */
  totalTokensUsed: number;
  /** Maximum token budget that was enforced */
  tokenBudget: number;
}

/** Interface for the MentionResolver dependency (decoupled for testing) */
export interface MentionResolverInterface {
  resolveAll(message: string): Promise<MentionResolutionResult>;
}

/** Interface for feature gate check */
export interface FeatureGateCheck {
  isEnabled(feature: string): boolean;
}

// ─── Preprocessor ───────────────────────────────────────────────

/**
 * ContextMentionsPreprocessor — Resolves @-mentions in user messages
 * before they reach the LLM.
 *
 * Usage in agent-loop:
 *   const preprocessor = new ContextMentionsPreprocessor(resolver, config);
 *   const result = await preprocessor.process(userMessage);
 *   // Use result.processedMessage as the message sent to the LLM
 */
export class ContextMentionsPreprocessor {
  private resolver: MentionResolverInterface;
  private config: Required<ContextMentionsConfig>;

  constructor(resolver: MentionResolverInterface, config: ContextMentionsConfig) {
    this.resolver = resolver;
    this.config = {
      budgetRatio: config.budgetRatio ?? DEFAULT_MENTION_BUDGET_RATIO,
      contextWindowTokens: config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      enabled: config.enabled,
    };
  }

  /**
   * Process a user message, resolving all @-mentions and injecting their content.
   *
   * The resolved content is appended after the clean message as clearly delineated
   * blocks (Req 14.3). A combined token budget limits total mention content (Req 14.7).
   *
   * If the feature is disabled or no mentions are found, returns the original message.
   *
   * @param message - The raw user message containing @-mention tokens
   * @returns Preprocessing result with transformed message and metadata
   */
  async process(message: string): Promise<MentionsPreprocessResult> {
    // Short-circuit if disabled
    if (!this.config.enabled) {
      return {
        processedMessage: message,
        hasMentions: false,
        resolvedCount: 0,
        droppedCount: 0,
        blockedCount: 0,
        totalTokensUsed: 0,
        tokenBudget: this.getTokenBudget(),
      };
    }

    // Quick check: does the message contain any @-mention patterns?
    if (!this.containsMentions(message)) {
      return {
        processedMessage: message,
        hasMentions: false,
        resolvedCount: 0,
        droppedCount: 0,
        blockedCount: 0,
        totalTokensUsed: 0,
        tokenBudget: this.getTokenBudget(),
      };
    }

    // Resolve all mentions via MentionResolver
    const resolution = await this.resolver.resolveAll(message);

    // Separate successfully resolved mentions from blocked/failed
    const resolvedMentions = resolution.resolvedMentions.filter(
      m => m.resolved && !m.blocked && m.content.length > 0,
    );
    const blockedCount = resolution.resolvedMentions.filter(m => m.blocked).length;

    // If no mentions resolved, return the clean message
    if (resolvedMentions.length === 0) {
      return {
        processedMessage: resolution.cleanMessage,
        hasMentions: true,
        resolvedCount: 0,
        droppedCount: 0,
        blockedCount,
        totalTokensUsed: 0,
        tokenBudget: this.getTokenBudget(),
      };
    }

    // Enforce combined token budget (Req 14.7)
    const tokenBudget = this.getTokenBudget();
    const { included, dropped } = this.applyTokenBudget(resolvedMentions, tokenBudget);

    // Build the processed message with injected content blocks
    const processedMessage = this.buildProcessedMessage(resolution.cleanMessage, included);

    const totalTokensUsed = included.reduce((sum, m) => sum + m.tokenEstimate, 0);

    return {
      processedMessage,
      hasMentions: true,
      resolvedCount: included.length,
      droppedCount: dropped,
      blockedCount,
      totalTokensUsed,
      tokenBudget,
    };
  }

  /**
   * Get the current token budget based on configuration.
   */
  getTokenBudget(): number {
    return Math.floor(this.config.contextWindowTokens * this.config.budgetRatio);
  }

  /**
   * Update the context window size (e.g., when model info becomes available).
   */
  setContextWindowTokens(tokens: number): void {
    this.config.contextWindowTokens = tokens;
  }

  /**
   * Update the budget ratio.
   */
  setBudgetRatio(ratio: number): void {
    this.config.budgetRatio = Math.max(0, Math.min(1, ratio));
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Quick check whether the message likely contains @-mention patterns.
   */
  private containsMentions(message: string): boolean {
    return /@(?:file|folder|url|git-diff|problems|terminal|selection)/.test(message);
  }

  /**
   * Apply the combined token budget, including mentions in order until budget is exhausted.
   * Mentions are included in their original order of appearance (Req 14.7).
   */
  private applyTokenBudget(
    mentions: ResolvedMention[],
    budget: number,
  ): { included: ResolvedMention[]; dropped: number } {
    const included: ResolvedMention[] = [];
    let tokensUsed = 0;
    let dropped = 0;

    for (const mention of mentions) {
      if (tokensUsed + mention.tokenEstimate <= budget) {
        included.push(mention);
        tokensUsed += mention.tokenEstimate;
      } else {
        dropped++;
      }
    }

    return { included, dropped };
  }

  /**
   * Build the final processed message by combining the clean user text
   * with clearly delineated resolved mention content blocks.
   *
   * Format (Req 14.3):
   *   <user message without mention tokens>
   *
   *   --- [context-mention: @type:value] ---
   *   <resolved content>
   *   --- [/context-mention] ---
   */
  private buildProcessedMessage(cleanMessage: string, mentions: ResolvedMention[]): string {
    if (mentions.length === 0) {
      return cleanMessage;
    }

    const mentionBlocks = mentions.map(m => {
      const label = m.mention.value
        ? `${m.mention.type}:${m.mention.value}`
        : m.mention.type;
      return `${MENTION_BLOCK_START}${label}] ---\n${m.content}\n${MENTION_BLOCK_END}`;
    });

    return `${cleanMessage}\n\n${mentionBlocks.join('\n\n')}`;
  }
}

/**
 * Factory function to create a ContextMentionsPreprocessor for use in the agent loop.
 *
 * Lazily loads the MentionResolver singleton and configures it based on the
 * feature gate state and optional config overrides.
 *
 * @param featureGate - Feature gate system to check `context_mentions` flag
 * @param config - Optional configuration overrides
 * @returns A configured preprocessor, or null if the feature is disabled
 */
export function createContextMentionsPreprocessor(
  featureGate: FeatureGateCheck | null,
  config?: Partial<ContextMentionsConfig>,
): ContextMentionsPreprocessor | null {
  const isEnabled = featureGate?.isEnabled('context_mentions') ?? false;

  if (!isEnabled) {
    return null;
  }

  // Lazy-load MentionResolver to avoid circular imports at module level
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MentionResolver } = require('../context/mention-resolver.js');
  const resolver = MentionResolver.getInstance();

  return new ContextMentionsPreprocessor(resolver, {
    enabled: true,
    budgetRatio: config?.budgetRatio ?? DEFAULT_MENTION_BUDGET_RATIO,
    contextWindowTokens: config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
  });
}
