/**
 * Prompt Enhancer — Pre-pipeline prompt rewriting for vague user messages.
 *
 * Detects short/vague prompts (< 50 tokens without clear deliverables) and
 * rewrites them using the cheapest model tier to add specificity, constraints,
 * and deliverables. Enhancement preserves the user's original intent — it adds
 * detail without changing the goal.
 *
 * Integration:
 * - Runs before BrainstormMode check in message processing pipeline (Req 8.4)
 * - Feature-gated behind `prompt_enhancement` flag
 * - Uses the existing tier-router 'fast' tier for model selection (Req 8.6)
 * - Follows NeuroNest's lazy-initialized TypeScript singleton pattern
 *
 * Requirements: 8.1, 8.3, 8.6, 8.7
 */

import type { LLMClient, LLMMessage } from './llm-client';

// ─── Constants ──────────────────────────────────────────────────

/** Token threshold below which prompts are candidates for enhancement (Req 8.1) */
export const ENHANCEMENT_TOKEN_THRESHOLD = 50;

/** Approximate chars-per-token ratio for quick token estimation */
export const CHARS_PER_TOKEN = 4;

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the PromptEnhancer */
export interface PromptEnhancerConfig {
  /** Whether prompt enhancement is enabled (Req 8.5) */
  enabled: boolean;
  /** Whether enhanced prompts are auto-applied without user confirmation (Req 8.2) */
  autoEnhance: boolean;
  /** Token threshold for triggering enhancement (default: 50) */
  tokenThreshold?: number;
}

/** Result of a prompt enhancement attempt */
export interface PromptEnhancementResult {
  /** Whether enhancement was performed */
  enhanced: boolean;
  /** The enhanced prompt (same as original if not enhanced) */
  prompt: string;
  /** The original prompt before enhancement */
  originalPrompt: string;
  /** Reason enhancement was skipped (if not enhanced) */
  skipReason?: PromptSkipReason;
}

/** Reasons a prompt may be skipped from enhancement */
export type PromptSkipReason =
  | 'disabled'
  | 'is_command'
  | 'is_acknowledgment'
  | 'is_question'
  | 'above_threshold'
  | 'has_clear_deliverables'
  | 'enhancement_failed';

/** Interface for feature gate dependency injection */
export interface FeatureGateCheck {
  isEnabled(feature: string): boolean;
}

// ─── Patterns ───────────────────────────────────────────────────

/** Patterns that detect slash commands (Req 8.7) */
const COMMAND_PATTERN = /^\s*\//;

/** Patterns that detect simple acknowledgments (Req 8.7) */
const ACKNOWLEDGMENT_PATTERNS = [
  /^\s*(ok|okay|sure|yes|no|yeah|yep|nope|thanks|thank you|got it|understood|roger|affirmative|cool|great|fine|alright|right|correct)\s*[.!?]*\s*$/i,
  /^\s*(lgtm|wfm|sgtm|ack|kk|k)\s*$/i,
];

/** Patterns that detect questions (questions don't need enhancement — they're already clear) */
const QUESTION_PATTERNS = [
  /^\s*(what|how|why|where|when|which|who|can you|could you|would you|is it|does it|do you|are you|will it|have you|has it)\b/i,
  /\?\s*$/,
];

/** Patterns that indicate the prompt already has clear deliverables */
const DELIVERABLE_PATTERNS = [
  /\b(create|implement|build|write|add|generate|make|produce|output|return|render|display|show)\b.*\b(file|function|class|component|module|endpoint|api|service|test|page|form|button|route|schema|migration)\b/i,
  /\b(fix|resolve|debug|patch|repair)\b.*\b(error|bug|issue|crash|failure|problem)\b/i,
  /\b(update|modify|change|refactor|rename|move|delete|remove)\b.*\b(file|function|class|variable|import|export|config|settings)\b/i,
  /\bstep\s*\d/i,
  /\b(must|should|shall)\b.*\b(return|accept|throw|emit|log|display)\b/i,
];

// ─── System Prompt ──────────────────────────────────────────────

const ENHANCEMENT_SYSTEM_PROMPT = `You are a prompt enhancement assistant. Your job is to take a vague or short user prompt and rewrite it into a clear, actionable specification with explicit deliverables.

Rules:
1. PRESERVE the user's original intent exactly — never change what they want, only add specificity
2. Add clear deliverables (what should be produced)
3. Add reasonable constraints (language, framework, patterns to follow)
4. Add acceptance criteria when appropriate (how to know it's done)
5. Keep the enhanced prompt concise — no more than 3-4 sentences
6. Use a direct, imperative tone (e.g., "Create a...", "Implement...")
7. Do NOT add requirements the user didn't imply
8. Do NOT ask questions — just produce the enhanced version
9. Output ONLY the enhanced prompt text, with no preamble or explanation`;

// ─── PromptEnhancer Class ───────────────────────────────────────

/**
 * PromptEnhancer — Detects vague prompts and rewrites them with added specificity.
 *
 * Usage in the agent-loop pipeline:
 *   const enhancer = new PromptEnhancer(llmClient, config);
 *   const result = await enhancer.enhance(userMessage);
 *   // If result.enhanced && config.autoEnhance → use result.prompt
 *   // If result.enhanced && !config.autoEnhance → show confirmation UI
 *   // If !result.enhanced → proceed with original message
 */
export class PromptEnhancer {
  private config: Required<PromptEnhancerConfig>;
  private llmClient: LLMClient | null;

  constructor(llmClient: LLMClient | null, config: PromptEnhancerConfig) {
    this.llmClient = llmClient;
    this.config = {
      enabled: config.enabled,
      autoEnhance: config.autoEnhance,
      tokenThreshold: config.tokenThreshold ?? ENHANCEMENT_TOKEN_THRESHOLD,
    };
  }

  /**
   * Attempt to enhance a user prompt.
   *
   * Short-circuits without LLM call when:
   * - Feature is disabled
   * - Message is a command (starts with `/`) — Req 8.7
   * - Message is a simple acknowledgment — Req 8.7
   * - Message is already a question
   * - Message exceeds the token threshold — Req 8.1
   * - Message already contains clear deliverables — Req 8.3
   *
   * @param message - The raw user message
   * @returns Enhancement result with original and enhanced prompts
   */
  async enhance(message: string): Promise<PromptEnhancementResult> {
    const original = message.trim();

    // Guard: feature disabled
    if (!this.config.enabled) {
      return this.skip(original, 'disabled');
    }

    // Guard: slash commands (Req 8.7)
    if (this.isCommand(original)) {
      return this.skip(original, 'is_command');
    }

    // Guard: simple acknowledgments (Req 8.7)
    if (this.isAcknowledgment(original)) {
      return this.skip(original, 'is_acknowledgment');
    }

    // Guard: questions don't need enhancement
    if (this.isQuestion(original)) {
      return this.skip(original, 'is_question');
    }

    // Guard: above token threshold (Req 8.1)
    if (!this.isBelowTokenThreshold(original)) {
      return this.skip(original, 'above_threshold');
    }

    // Guard: already has clear deliverables (Req 8.3)
    if (this.hasClearDeliverables(original)) {
      return this.skip(original, 'has_clear_deliverables');
    }

    // Perform enhancement via LLM (Req 8.6 — cheapest tier)
    const enhanced = await this.rewritePrompt(original);
    if (!enhanced) {
      return this.skip(original, 'enhancement_failed');
    }

    return {
      enhanced: true,
      prompt: enhanced,
      originalPrompt: original,
    };
  }

  // ─── Detection Methods ──────────────────────────────────────────

  /**
   * Check if a message is a slash command (Req 8.7).
   */
  isCommand(message: string): boolean {
    return COMMAND_PATTERN.test(message);
  }

  /**
   * Check if a message is a simple acknowledgment (Req 8.7).
   */
  isAcknowledgment(message: string): boolean {
    return ACKNOWLEDGMENT_PATTERNS.some(pattern => pattern.test(message));
  }

  /**
   * Check if a message is a question.
   */
  isQuestion(message: string): boolean {
    return QUESTION_PATTERNS.some(pattern => pattern.test(message));
  }

  /**
   * Check if message is below the token threshold (Req 8.1).
   * Uses a simple character-based estimate: ~4 chars per token.
   */
  isBelowTokenThreshold(message: string): boolean {
    const estimatedTokens = Math.ceil(message.length / CHARS_PER_TOKEN);
    return estimatedTokens < this.config.tokenThreshold;
  }

  /**
   * Check if message already contains clear deliverables (Req 8.3).
   * If the user is already specific, enhancement would risk changing intent.
   */
  hasClearDeliverables(message: string): boolean {
    return DELIVERABLE_PATTERNS.some(pattern => pattern.test(message));
  }

  // ─── Enhancement Logic ──────────────────────────────────────────

  /**
   * Rewrite a vague prompt into a detailed specification via LLM call.
   * Uses the cheapest model tier (Req 8.6).
   *
   * @returns Enhanced prompt string, or null if enhancement fails
   */
  private async rewritePrompt(message: string): Promise<string | null> {
    if (!this.llmClient) {
      return null;
    }

    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: ENHANCEMENT_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ];

      const response = await this.llmClient.chat(messages, {
        temperature: 0.3,
        maxTokens: 256,
      });

      const enhanced = response.content?.trim();
      if (!enhanced || enhanced.length === 0) {
        return null;
      }

      return enhanced;
    } catch {
      // Enhancement is best-effort — failures should not block the pipeline
      return null;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Create a skip result with the given reason.
   */
  private skip(original: string, reason: PromptSkipReason): PromptEnhancementResult {
    return {
      enhanced: false,
      prompt: original,
      originalPrompt: original,
      skipReason: reason,
    };
  }

  // ─── Configuration ────────────────────────────────────────────────

  /** Get current configuration */
  getConfig(): Readonly<Required<PromptEnhancerConfig>> {
    return { ...this.config };
  }

  /** Update configuration at runtime (Req 8.5 — per-session toggle) */
  setConfig(config: Partial<PromptEnhancerConfig>): void {
    if (config.enabled !== undefined) this.config.enabled = config.enabled;
    if (config.autoEnhance !== undefined) this.config.autoEnhance = config.autoEnhance;
    if (config.tokenThreshold !== undefined) this.config.tokenThreshold = config.tokenThreshold;
  }

  /** Update the LLM client (e.g., on provider change) */
  setLLMClient(client: LLMClient | null): void {
    this.llmClient = client;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Factory function to create a PromptEnhancer for use in the agent loop.
 *
 * Resolves the cheapest-tier LLM client via the tier-router and configures
 * the enhancer based on feature gate state.
 *
 * @param featureGate - Feature gate system to check `prompt_enhancement` flag
 * @param llmClient - LLM client configured for 'fast' (cheapest) tier
 * @param config - Optional configuration overrides
 * @returns A configured PromptEnhancer, or null if the feature is disabled
 */
export function createPromptEnhancer(
  featureGate: FeatureGateCheck | null,
  llmClient: LLMClient | null,
  config?: Partial<PromptEnhancerConfig>,
): PromptEnhancer | null {
  const isEnabled = featureGate?.isEnabled('prompt_enhancement') ?? false;

  if (!isEnabled) {
    return null;
  }

  return new PromptEnhancer(llmClient, {
    enabled: true,
    autoEnhance: config?.autoEnhance ?? false,
    tokenThreshold: config?.tokenThreshold ?? ENHANCEMENT_TOKEN_THRESHOLD,
  });
}
