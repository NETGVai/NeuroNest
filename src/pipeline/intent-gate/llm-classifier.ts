/**
 * LLMClassifier — Stage B of the Intent Gate classification cascade.
 *
 * Invoked when PatternClassifier (Stage A) produces a mid-confidence result
 * (0.4–0.85). Uses the tier-router 'fast' tier model with temperature 0 for
 * deterministic classification into the unified taxonomy.
 *
 * Key constraints:
 * - 800ms hard timeout via AbortController
 * - Returns null on timeout/error (IntentGate handles fallback to Stage A)
 * - Temperature 0 for deterministic output
 * - Max ~150 tokens response
 * - Returns complexity tier for build intents
 *
 * Requirements: 2.3, 2.4, 2.5, 15.3
 */

import type {
  IntentLabel,
  ComplexityTier,
  LLMClassifierResult,
  LLMClassifier,
} from '../intent-gate.js';

// ─── LLM Client Dependency ─────────────────────────────────────────────────

/**
 * Minimal interface for the LLM client dependency.
 * Accepts an AbortSignal for timeout enforcement.
 */
export interface LLMClient {
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ content: string } | null>;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface LLMClassifierConfig {
  /** Hard timeout in milliseconds (default 800). */
  timeoutMs: number;
  /** Model tier — uses tier-router 'fast' tier. */
  model: 'fast';
  /** Temperature for deterministic output (default 0). */
  temperature: number;
  /** Max response tokens (~150). */
  maxTokens: number;
}

export const DEFAULT_LLM_CLASSIFIER_CONFIG: LLMClassifierConfig = {
  timeoutMs: 800,
  model: 'fast',
  temperature: 0,
  maxTokens: 150,
};

// ─── Classification Prompt ──────────────────────────────────────────────────

const CLASSIFICATION_SYSTEM_PROMPT = `You are an intent classifier for a developer assistant. Classify the user's message into exactly one intent category and assess complexity if it's a build task.

Intent categories:
- conversation: Questions, explanations, discussions — no code changes needed
- quick_action: Simple single-step actions (rename, delete, format, run a command)
- build: Multi-step tasks requiring planning, code generation, or architecture

Output ONLY a JSON object with these fields:
{
  "intent": "conversation" | "quick_action" | "build",
  "confidence": <number 0-1>,
  "complexity": null | "trivial" | "medium" | "complex",
  "reasoning": "<brief explanation>"
}

Rules:
- confidence: how certain you are (0.5 = uncertain, 0.9+ = very sure)
- complexity: ONLY set for "build" intent. null for conversation/quick_action.
  - trivial: single file, straightforward change (add a button, fix a typo in logic)
  - medium: 2-5 files, moderate planning needed
  - complex: 6+ files, architecture decisions, multiple subsystems
- Keep reasoning under 20 words
- Output ONLY valid JSON, no markdown fences, no extra text`;

// ─── Valid Values ───────────────────────────────────────────────────────────

const VALID_INTENTS: Set<string> = new Set(['conversation', 'quick_action', 'build']);
const VALID_COMPLEXITIES: Set<string> = new Set(['trivial', 'medium', 'complex']);

// ─── Response Parser ────────────────────────────────────────────────────────

/**
 * Parse the LLM response into a typed LLMClassifierResult.
 * Returns null if the response cannot be parsed into a valid result.
 */
export function parseLLMResponse(raw: string): LLMClassifierResult | null {
  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    // Validate intent field
    const intent = parsed.intent;
    if (!VALID_INTENTS.has(intent)) {
      return null;
    }

    // Validate confidence
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    // Validate complexity — must be null for non-build, valid tier for build
    let complexity: ComplexityTier | null = null;
    if (intent === 'build') {
      if (parsed.complexity && VALID_COMPLEXITIES.has(parsed.complexity)) {
        complexity = parsed.complexity as ComplexityTier;
      } else {
        // Default to 'medium' if build intent but no/invalid complexity specified
        complexity = 'medium';
      }
    }

    // Extract reasoning
    const reasoning = typeof parsed.reasoning === 'string'
      ? parsed.reasoning.slice(0, 200)
      : 'No reasoning provided';

    return {
      intent: intent as IntentLabel,
      confidence,
      complexity,
      reasoning,
    };
  } catch {
    return null;
  }
}

// ─── LLMClassifier Implementation ──────────────────────────────────────────

export class LLMClassifierImpl implements LLMClassifier {
  private readonly config: LLMClassifierConfig;
  private readonly client: LLMClient;

  constructor(client: LLMClient, config?: Partial<LLMClassifierConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_LLM_CLASSIFIER_CONFIG, ...config };
  }

  /**
   * Classify a message using the LLM with hard timeout enforcement.
   *
   * Returns null on:
   * - Timeout (AbortController fires at the configured timeoutMs)
   * - LLM error (network, rate limit, etc.)
   * - Unparseable response
   *
   * The IntentGate handles fallback to Stage A when null is returned.
   */
  async classify(message: string, timeout: number): Promise<LLMClassifierResult | null> {
    const effectiveTimeout = Math.min(timeout, this.config.timeoutMs);

    // Create AbortController for hard timeout enforcement
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await this.client.chat(
        [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        {
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          signal: controller.signal,
        },
      );

      // LLM returned no response
      if (!response || !response.content) {
        return null;
      }

      // Parse the structured response
      return parseLLMResponse(response.content);
    } catch {
      // Timeout, abort, network error, or any other failure → return null
      // IntentGate will fall back to Stage A result
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
