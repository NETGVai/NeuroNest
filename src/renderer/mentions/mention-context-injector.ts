/**
 * MentionContextInjector — Resolves mentions and injects content into agent context.
 *
 * Responsibilities:
 * - Resolve all active mentions to their content via IPC
 * - Enforce combined token budget (default: 30% of context window)
 * - Format resolved content as clearly delineated blocks
 * - Track token usage across all mentions
 *
 * Requirements: 14.3, 14.7
 */

import type { MentionChipData } from './mention-chip';
import type { ResolvedMentionContent, MentionType } from './mention-ipc-client';
import { getMentionIpcClient } from './mention-ipc-client';

// ─── Constants ──────────────────────────────────────────────────

/** Default context window size in tokens (128K) */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Default mention budget as fraction of context window */
export const DEFAULT_MENTION_BUDGET_FRACTION = 0.30;

/** Block boundary marker for delineated content */
export const BLOCK_START_MARKER = '<<< MENTION_CONTEXT_START';
export const BLOCK_END_MARKER = '>>> MENTION_CONTEXT_END';

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for context injection */
export interface MentionInjectorConfig {
  /** Total context window size in tokens */
  contextWindowTokens?: number;
  /** Fraction of context window available for mentions (0.0 - 1.0) */
  mentionBudgetFraction?: number;
}

/** A single resolved mention ready for injection */
export interface InjectedMention {
  /** The original chip data */
  chip: MentionChipData;
  /** Resolved content from the main process */
  content: string;
  /** Token estimate for this mention's content */
  tokenEstimate: number;
  /** Whether it was truncated due to budget */
  budgetTruncated: boolean;
  /** Whether it was included in the final injection */
  included: boolean;
  /** Reason for exclusion (if not included) */
  exclusionReason?: string;
}

/** Result of context injection */
export interface InjectionResult {
  /** The formatted context string ready for agent injection */
  contextBlock: string;
  /** Details about each mention's resolution */
  mentions: InjectedMention[];
  /** Total tokens used by all included mentions */
  totalTokensUsed: number;
  /** Total token budget available */
  totalBudget: number;
  /** Whether any mentions were excluded due to budget */
  budgetExceeded: boolean;
}

// ─── MentionContextInjector ─────────────────────────────────────

/**
 * MentionContextInjector — Resolves and injects mention content into agent context.
 *
 * Orchestrates the resolution of all active mentions, enforces the combined
 * token budget, and formats the content as delineated blocks for the agent.
 */
export class MentionContextInjector {
  private config: Required<MentionInjectorConfig>;

  constructor(config: MentionInjectorConfig = {}) {
    this.config = {
      contextWindowTokens: config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      mentionBudgetFraction: config.mentionBudgetFraction ?? DEFAULT_MENTION_BUDGET_FRACTION,
    };
  }

  /**
   * Get the total token budget for mentions.
   */
  getTotalBudget(): number {
    return Math.floor(this.config.contextWindowTokens * this.config.mentionBudgetFraction);
  }

  /**
   * Update the injector configuration.
   */
  updateConfig(config: Partial<MentionInjectorConfig>): void {
    if (config.contextWindowTokens !== undefined) {
      this.config.contextWindowTokens = config.contextWindowTokens;
    }
    if (config.mentionBudgetFraction !== undefined) {
      this.config.mentionBudgetFraction = config.mentionBudgetFraction;
    }
  }

  /**
   * Resolve all mentions and produce the injection result.
   *
   * Resolves each mention via IPC, enforces the combined token budget,
   * and formats the content as delineated blocks.
   *
   * @param chips - The active mention chips to resolve
   * @returns Injection result with formatted context and details
   */
  async resolveAndInject(chips: MentionChipData[]): Promise<InjectionResult> {
    const totalBudget = this.getTotalBudget();
    const client = getMentionIpcClient();

    const injectedMentions: InjectedMention[] = [];
    let totalTokensUsed = 0;
    let budgetExceeded = false;

    // Resolve mentions in order, respecting budget
    for (const chip of chips) {
      const resolved = await client.resolveMention({
        type: chip.type,
        value: chip.fullValue,
      });

      if (!resolved.resolved || resolved.blocked) {
        injectedMentions.push({
          chip,
          content: '',
          tokenEstimate: 0,
          budgetTruncated: false,
          included: false,
          exclusionReason: resolved.blocked ? 'blocked_by_firewall' : (resolved.error ?? 'resolution_failed'),
        });
        continue;
      }

      const remainingBudget = totalBudget - totalTokensUsed;

      if (remainingBudget <= 0) {
        // No budget remaining
        budgetExceeded = true;
        injectedMentions.push({
          chip,
          content: '',
          tokenEstimate: resolved.tokenEstimate,
          budgetTruncated: true,
          included: false,
          exclusionReason: 'budget_exceeded',
        });
        continue;
      }

      let content = resolved.content;
      let tokenEstimate = resolved.tokenEstimate;
      let budgetTruncated = false;

      // Truncate content if it exceeds remaining budget
      if (tokenEstimate > remainingBudget) {
        budgetExceeded = true;
        budgetTruncated = true;
        // Approximate: 1 token ~ 4 characters
        const maxChars = remainingBudget * 4;
        content = content.slice(0, maxChars) + '\n\n[Truncated: mention content exceeds remaining token budget]';
        tokenEstimate = remainingBudget;
      }

      totalTokensUsed += tokenEstimate;

      injectedMentions.push({
        chip,
        content,
        tokenEstimate,
        budgetTruncated,
        included: true,
      });
    }

    // Format the context block
    const contextBlock = this.formatContextBlock(injectedMentions.filter(m => m.included));

    return {
      contextBlock,
      mentions: injectedMentions,
      totalTokensUsed,
      totalBudget,
      budgetExceeded,
    };
  }

  /**
   * Format resolved mentions as a single context block with clear boundaries.
   *
   * Each mention is wrapped in start/end markers with type and name metadata.
   */
  private formatContextBlock(included: InjectedMention[]): string {
    if (included.length === 0) return '';

    const blocks: string[] = [];

    for (const mention of included) {
      const header = `${BLOCK_START_MARKER} [${mention.chip.type}:${mention.chip.fullValue}] >>>`;
      const footer = `${BLOCK_END_MARKER} [${mention.chip.type}:${mention.chip.fullValue}] <<<`;

      blocks.push(`${header}\n${mention.content}\n${footer}`);
    }

    return blocks.join('\n\n');
  }
}

/** Singleton instance */
let injectorInstance: MentionContextInjector | null = null;

/**
 * Get the singleton MentionContextInjector instance.
 */
export function getMentionContextInjector(config?: MentionInjectorConfig): MentionContextInjector {
  if (!injectorInstance) {
    injectorInstance = new MentionContextInjector(config);
  }
  return injectorInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetMentionContextInjector(): void {
  injectorInstance = null;
}
