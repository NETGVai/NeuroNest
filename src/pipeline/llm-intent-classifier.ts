/**
 * LLM-Based Intent Classifier
 *
 * Uses a configured reasoning model to classify user message intent instead of
 * brittle regex patterns. Falls back to the legacy pattern-based classifier
 * when no LLM is available.
 *
 * The LLM receives a tight system prompt that asks it to classify the message
 * into one of: informational, execution, or ambiguous — and respond with a
 * single JSON object. This is a fast, low-token call (~200 tokens total).
 */

import type { LLMClient } from './llm-client';

export interface LLMClassificationResult {
  intent: 'informational' | 'simple_action' | 'build_task' | 'ambiguous';
  confidence: number;
  reasoning: string;
}

const CLASSIFICATION_SYSTEM_PROMPT = `You are an intent classifier for an AI coding IDE called NeuroNest. The user has an active project open.

Classify the user's message into exactly ONE of these intents:

1. "informational" — The user is asking a QUESTION or wants an explanation. They are NOT commanding you to perform an action. ANY message that starts with "can I", "could I", "is it", "how do I", "what is", "should I", or ends with "?" is almost always informational. Examples:
   - "Can I build a nodejs app?" (asking IF they can — NOT asking you to build one)
   - "Can you build apps?" (asking about capabilities)
   - "What is React?" (asking for explanation)
   - "How does the routing work?" (asking for explanation)
   - "Is it possible to deploy to AWS?" (asking about possibility)
   - "Should I use TypeScript or JavaScript?" (asking for advice)
   - "Tell me about this project" (asking for information)
   - "What frameworks do you support?" (asking about capabilities)

2. "simple_action" — The user wants a SIMPLE, single-step action performed. These are IMPERATIVE commands (not questions). Examples:
   - "Delete the test files from the project" (imperative: do this)
   - "Rename main.ts to index.ts" (imperative: do this)
   - "Add a comment to this function" (imperative: do this)
   - "Format this code" (imperative: do this)
   - "Remove unused imports" (imperative: do this)
   - "Refactor this function" (imperative: do this)

3. "build_task" — The user wants something BUILT or CREATED. These are IMPERATIVE commands for complex multi-step work. Examples:
   - "Build me a todo app" (imperative: create this)
   - "Create a REST API with authentication" (imperative: build this)
   - "Add a login page with form validation" (imperative: build this)
   - "Set up a CI/CD pipeline" (imperative: build this)
   - "Build a nodejs app" (imperative: build this — no question mark, no "can I")

4. "ambiguous" — Genuinely unclear. Use this sparingly.

CRITICAL RULES:
- Questions ("Can I...?", "Is it...?", "How do I...?", "What is...?") are ALWAYS "informational" — even if they mention code topics.
- "Can I build X?" is informational (asking permission/capability). "Build X" is build_task (commanding action).
- The PRESENCE of a question word (can, could, is, how, what, should, would, will, does, do) at the START makes it informational.
- File operations (delete, rename, move) in imperative form are "simple_action".
- Only classify as "build_task" when the user is clearly COMMANDING you to create/build something (imperative mood, no question marks).

Respond with ONLY a JSON object, no markdown, no explanation:
{"intent": "informational"|"simple_action"|"build_task"|"ambiguous", "confidence": 0.0-1.0, "reasoning": "brief reason"}`;

/**
 * Classify user message intent using an LLM.
 * Returns null if the LLM call fails (caller should fall back to pattern-based).
 */
export async function classifyIntentWithLLM(
  message: string,
  llmClient: LLMClient
): Promise<LLMClassificationResult | null> {
  try {
    // Race the LLM call against a 3-second timeout
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
    
    const llmPromise = llmClient.chat(
      [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      { temperature: 0, maxTokens: 100 }
    );

    const response = await Promise.race([llmPromise, timeoutPromise]);
    if (!response || !response.content) return null;

    // Parse the JSON response — handle potential markdown wrapping
    let jsonStr = response.content.trim();
    // Strip markdown code fences if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate the response structure
    if (!parsed.intent || !['informational', 'simple_action', 'build_task', 'ambiguous'].includes(parsed.intent)) {
      return null;
    }

    return {
      intent: parsed.intent,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.8,
      reasoning: parsed.reasoning || '',
    };
  } catch (err: any) {
    console.warn('[LLMIntentClassifier] Classification failed, will fall back to patterns:', err?.message);
    return null;
  }
}
