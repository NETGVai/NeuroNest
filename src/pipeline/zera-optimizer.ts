// ZERA — Zero-init Instruction Evolving Refinement Agent
// Rule-based prompt optimizer that evaluates and restructures user prompts
// using 8 evaluation principles before they enter the orchestration pipeline.

export interface ZeraStep {
  principle: string;
  score: number;
  suggestion: string;
}

export interface ZeraResult {
  originalPrompt: string;
  optimizedPrompt: string;
  steps: ZeraStep[];
}

export type ZeraProgressCallback = (step: ZeraStep, index: number) => void;

// ── Principle evaluators ────────────────────────────────────────────────

interface PrincipleEvaluator {
  name: string;
  evaluate: (prompt: string) => { score: number; suggestion: string };
  apply: (prompt: string) => string;
}

const FILLER_WORDS = [
  'just', 'maybe', 'perhaps', 'kind of', 'sort of', 'basically',
  'actually', 'really', 'very', 'quite', 'simply', 'obviously',
  'literally', 'honestly', 'like', 'stuff', 'things', 'etc',
];

const VAGUE_TERMS = [
  'good', 'nice', 'better', 'fast', 'efficient', 'clean',
  'proper', 'optimal', 'best', 'great', 'cool', 'awesome',
];

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
}

function containsAny(text: string, words: string[]): string[] {
  const lower = text.toLowerCase();
  return words.filter((w) => lower.includes(w));
}

function hasNumberedList(text: string): boolean {
  return /\d+[.)]\s/.test(text);
}

function hasBulletList(text: string): boolean {
  return /^[\s]*[-*•]\s/m.test(text);
}

function hasQuestionMark(text: string): boolean {
  return text.includes('?');
}

// ── The 8 ZERA principles ───────────────────────────────────────────────

const PRINCIPLES: PrincipleEvaluator[] = [
  // 1. Correctness — unambiguous intent
  {
    name: 'Correctness',
    evaluate(prompt) {
      const ambiguousPronouns = containsAny(prompt, ['it', 'this', 'that', 'they', 'them']);
      const hasQuestion = hasQuestionMark(prompt);
      const sentences = sentenceCount(prompt);
      const pronounRatio = ambiguousPronouns.length / Math.max(sentences, 1);

      let score = 80;
      if (pronounRatio > 1) score -= 25;
      if (hasQuestion && sentences === 1) score += 10;
      if (sentences > 5 && !hasNumberedList(prompt) && !hasBulletList(prompt)) score -= 15;
      score = Math.max(0, Math.min(100, score));

      const suggestion =
        pronounRatio > 1
          ? 'Replace ambiguous pronouns (it, this, that) with explicit nouns to clarify intent.'
          : sentences > 5
            ? 'Long prompt detected — consider breaking into numbered requirements for clarity.'
            : 'Intent is reasonably clear.';

      return { score, suggestion };
    },
    apply(prompt) {
      // No automated rewrite for correctness — it's evaluated only
      return prompt;
    },
  },

  // 2. Reasoning Quality — step-by-step cues
  {
    name: 'Reasoning Quality',
    evaluate(prompt) {
      const reasoningCues = containsAny(prompt, [
        'step by step', 'first', 'then', 'finally', 'because',
        'reason', 'explain', 'why', 'how', 'consider',
      ]);
      const score = Math.min(100, 40 + reasoningCues.length * 15);
      const suggestion =
        reasoningCues.length < 2
          ? 'Add reasoning cues like "step by step", "first…then…finally" to guide structured thinking.'
          : 'Good reasoning structure detected.';
      return { score, suggestion };
    },
    apply(prompt) {
      const hasReasoning = containsAny(prompt, ['step by step', 'first', 'then', 'finally']).length >= 2;
      if (hasReasoning) return prompt;
      return prompt + '\nApproach this step by step.';
    },
  },

  // 3. Conciseness — remove filler
  {
    name: 'Conciseness',
    evaluate(prompt) {
      const found = containsAny(prompt, FILLER_WORDS);
      const words = wordCount(prompt);
      const fillerRatio = found.length / Math.max(words, 1);
      let score = 90 - Math.round(fillerRatio * 500);
      if (words > 200) score -= 10;
      score = Math.max(0, Math.min(100, score));

      const suggestion =
        found.length > 0
          ? `Remove filler words: ${found.slice(0, 5).join(', ')}.`
          : 'Prompt is concise.';
      return { score, suggestion };
    },
    apply(prompt) {
      let result = prompt;
      for (const filler of FILLER_WORDS) {
        // Replace filler words surrounded by word boundaries or spaces
        const regex = new RegExp(`\\b${filler}\\b\\s*`, 'gi');
        result = result.replace(regex, '');
      }
      // Collapse multiple spaces
      return result.replace(/\s{2,}/g, ' ').trim();
    },
  },

  // 4. Completeness — fill implicit requirements
  {
    name: 'Completeness',
    evaluate(prompt) {
      const hasFormat = containsAny(prompt, ['format', 'output', 'return', 'respond', 'deliver']).length > 0;
      const hasConstraints = containsAny(prompt, ['must', 'should', 'require', 'constraint', 'limit']).length > 0;
      const hasContext = containsAny(prompt, ['context', 'background', 'given', 'assuming', 'using']).length > 0;

      let score = 30;
      if (hasFormat) score += 25;
      if (hasConstraints) score += 25;
      if (hasContext) score += 20;
      score = Math.max(0, Math.min(100, score));

      const missing: string[] = [];
      if (!hasFormat) missing.push('output format');
      if (!hasConstraints) missing.push('constraints or requirements');
      if (!hasContext) missing.push('context or assumptions');

      const suggestion =
        missing.length > 0
          ? `Consider specifying: ${missing.join(', ')}.`
          : 'Prompt covers format, constraints, and context.';
      return { score, suggestion };
    },
    apply(prompt) {
      const additions: string[] = [];
      const hasFormat = containsAny(prompt, ['format', 'output', 'return', 'respond', 'deliver']).length > 0;
      const hasConstraints = containsAny(prompt, ['must', 'should', 'require', 'constraint', 'limit']).length > 0;

      if (!hasFormat) additions.push('Provide the output in a structured, clearly labeled format.');
      if (!hasConstraints) additions.push('Include any relevant constraints and edge cases.');

      if (additions.length === 0) return prompt;
      return prompt + '\n' + additions.join(' ');
    },
  },

  // 5. Specificity — concrete measurable criteria
  {
    name: 'Specificity',
    evaluate(prompt) {
      const vague = containsAny(prompt, VAGUE_TERMS);
      const hasNumbers = /\d+/.test(prompt);
      const hasExamples = containsAny(prompt, ['example', 'e.g.', 'such as', 'for instance']).length > 0;

      let score = 70;
      score -= vague.length * 10;
      if (hasNumbers) score += 15;
      if (hasExamples) score += 15;
      score = Math.max(0, Math.min(100, score));

      const suggestion =
        vague.length > 0
          ? `Replace vague terms with measurable criteria: ${vague.slice(0, 4).join(', ')}.`
          : 'Prompt uses specific language.';
      return { score, suggestion };
    },
    apply(prompt) {
      let result = prompt;
      const replacements: Record<string, string> = {
        'good': 'high-quality',
        'nice': 'well-structured',
        'better': 'improved with measurable gains',
        'fast': 'optimized for low latency',
        'efficient': 'resource-efficient',
        'clean': 'maintainable and well-documented',
        'proper': 'following established conventions',
        'optimal': 'benchmarked for peak performance',
        'best': 'industry-standard',
        'great': 'production-ready',
      };
      for (const [vague, specific] of Object.entries(replacements)) {
        const regex = new RegExp(`\\b${vague}\\b`, 'gi');
        result = result.replace(regex, specific);
      }
      return result;
    },
  },

  // 6. Relevance — focus on what matters
  {
    name: 'Relevance',
    evaluate(prompt) {
      const sentences = prompt.split(/[.!?]+/).filter((s) => s.trim().length > 0);
      const words = wordCount(prompt);
      // Heuristic: very short prompts are focused; very long ones may drift
      let score = 85;
      if (words > 150) score -= 15;
      if (sentences.length > 8) score -= 10;
      score = Math.max(0, Math.min(100, score));

      const suggestion =
        words > 150
          ? 'Prompt is lengthy — trim tangential details and keep only what directly affects the deliverable.'
          : 'Prompt stays focused on the core request.';
      return { score, suggestion };
    },
    apply(prompt) {
      // Relevance trimming is risky to automate — leave as-is
      return prompt;
    },
  },

  // 7. Structure — numbered deliverables
  {
    name: 'Structure',
    evaluate(prompt) {
      const numbered = hasNumberedList(prompt);
      const bulleted = hasBulletList(prompt);
      const hasHeaders = /^#+\s/m.test(prompt);
      const sentences = sentenceCount(prompt);

      let score = 40;
      if (numbered) score += 30;
      if (bulleted) score += 20;
      if (hasHeaders) score += 10;
      if (sentences <= 2) score += 10; // short prompts don't need structure
      score = Math.max(0, Math.min(100, score));

      const suggestion =
        !numbered && sentences > 2
          ? 'Add numbered deliverables so each requirement is trackable and assignable.'
          : 'Prompt has good structural organization.';
      return { score, suggestion };
    },
    apply(prompt) {
      if (hasNumberedList(prompt) || sentenceCount(prompt) <= 2) return prompt;

      // Split sentences and number them as deliverables
      const sentences = prompt
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (sentences.length <= 1) return prompt;

      // Keep the first sentence as the objective, number the rest
      const objective = sentences[0];
      const deliverables = sentences.slice(1);

      let structured = `Objective: ${objective}.\n\nDeliverables:`;
      deliverables.forEach((d, i) => {
        structured += `\n${i + 1}. ${d}.`;
      });
      return structured;
    },
  },

  // 8. Actionability — every point maps to an agent action
  {
    name: 'Actionability',
    evaluate(prompt) {
      const actionVerbs = containsAny(prompt, [
        'build', 'create', 'design', 'implement', 'write', 'test',
        'deploy', 'analyze', 'optimize', 'review', 'fix', 'refactor',
        'document', 'plan', 'research', 'migrate', 'audit', 'configure',
      ]);
      let score = Math.min(100, 30 + actionVerbs.length * 20);
      score = Math.max(0, Math.min(100, score));

      const suggestion =
        actionVerbs.length < 2
          ? 'Use action verbs (build, create, test, deploy) so each point maps to a concrete agent task.'
          : `Good actionability — detected verbs: ${actionVerbs.slice(0, 5).join(', ')}.`;
      return { score, suggestion };
    },
    apply(prompt) {
      // Actionability is structural — no safe automated rewrite
      return prompt;
    },
  },
];


// ── Word-limit enforcer ─────────────────────────────────────────────────

function enforceWordLimit(text: string, limit: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return text;
  return words.slice(0, limit).join(' ') + '…';
}

// ── ZeraOptimizer class ─────────────────────────────────────────────────

export class ZeraOptimizer {
  private readonly principles: PrincipleEvaluator[] = PRINCIPLES;
  private readonly maxWords = 500;
  private llmClient: any = null;

  /**
   * Set the LLM client for framework-based optimization.
   * When set, the optimizer uses Promptly-style frameworks (TCRTE, CoT, Few-Shot)
   * via the LLM instead of only rule-based transformations.
   */
  setLLMClient(client: any): void {
    this.llmClient = client;
  }

  /**
   * Evaluate and optimize a raw user prompt.
   *
   * When an LLM client is available, uses Promptly-style framework optimization:
   * - TCRTE (Role, Context, Task, Constraints, Output Format) — for build/planning tasks
   * - Chain-of-Thought — for debugging, reasoning, analysis tasks
   * - Few-Shot — for style/format/pattern matching tasks
   *
   * Falls back to rule-based ZERA principles when no LLM is available.
   */
  async optimize(prompt: string, onProgress?: ZeraProgressCallback): Promise<ZeraResult> {
    const steps: ZeraStep[] = [];
    let working = prompt.trim();

    // Step 1: Run rule-based principles for scoring and quick fixes
    for (let i = 0; i < this.principles.length; i++) {
      const principle = this.principles[i];
      const { score, suggestion } = principle.evaluate(working);

      const step: ZeraStep = {
        principle: principle.name,
        score,
        suggestion,
      };
      steps.push(step);

      if (score < 75) {
        working = principle.apply(working);
      }

      if (onProgress) {
        onProgress(step, i);
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Step 2: If LLM is available, apply Promptly framework optimization
    if (this.llmClient) {
      try {
        const framework = this.selectFramework(working);
        const frameworkResult = await this.applyFramework(working, framework);

        if (frameworkResult) {
          working = frameworkResult;

          // Report the framework step
          const frameworkStep: ZeraStep = {
            principle: `Framework: ${framework}`,
            score: 95,
            suggestion: `Restructured using ${framework} framework for optimal LLM comprehension.`,
          };
          steps.push(frameworkStep);
          if (onProgress) {
            onProgress(frameworkStep, steps.length - 1);
          }
        }
      } catch (err: any) {
        console.warn('[ZERA] Framework optimization failed, using rule-based result:', err?.message);
      }
    }

    const optimizedPrompt = enforceWordLimit(working, this.maxWords);

    return {
      originalPrompt: prompt,
      optimizedPrompt,
      steps,
    };
  }

  /**
   * Select the best Promptly framework based on the prompt content.
   * - TCRTE: build tasks, planning, work, structured output
   * - Chain-of-Thought: debugging, reasoning, analysis, decisions
   * - Few-Shot: style matching, format copying, pattern replication
   */
  private selectFramework(prompt: string): 'TCRTE' | 'CoT' | 'FewShot' {
    const lower = prompt.toLowerCase();

    // Chain-of-Thought indicators
    const cotSignals = [
      'debug', 'why', 'reason', 'analyze', 'compare', 'decide',
      'trade-off', 'tradeoff', 'evaluate', 'diagnose', 'investigate',
      'step by step', 'think through', 'figure out', 'root cause',
    ];
    const cotScore = cotSignals.filter(s => lower.includes(s)).length;

    // Few-Shot indicators
    const fewShotSignals = [
      'like this', 'same style', 'similar to', 'format like',
      'match the tone', 'copy the pattern', 'following example',
      'in the style of', 'same way as',
    ];
    const fewShotScore = fewShotSignals.filter(s => lower.includes(s)).length;

    if (fewShotScore >= 2) return 'FewShot';
    if (cotScore >= 2) return 'CoT';
    return 'TCRTE'; // Default for build/planning tasks
  }

  /**
   * Apply a Promptly framework to restructure the prompt using the LLM.
   * Returns the restructured prompt, or null if the call fails.
   */
  private async applyFramework(prompt: string, framework: 'TCRTE' | 'CoT' | 'FewShot'): Promise<string | null> {
    const systemPrompts: Record<string, string> = {
      TCRTE: `You are an expert prompt engineer. Rewrite the user's raw prompt using the TCRTE framework.

Structure the output with these clearly labeled sections:
## ROLE
Who the AI should be (expertise, perspective)

## CONTEXT
Background information and current situation

## TASK
What specifically needs to be done (clear, actionable)

## CONSTRAINTS
Rules, limits, requirements, edge cases to handle

## OUTPUT FORMAT
How the result should be structured and delivered

Rules: Preserve the user's intent completely. Use the exact headers above. Make each section specific and actionable. Return ONLY the improved prompt with the headers.`,

      CoT: `You are an expert prompt engineer. Rewrite the user's raw prompt using Chain-of-Thought (CoT) framework.

Structure the output with:
## OBJECTIVE
Clear statement of what needs to be solved/decided

## REASONING STEPS
Numbered step-by-step instructions for how to think through the problem:
1. First, analyze...
2. Then, consider...
3. Next, evaluate...
4. Finally, synthesize...

## EXPECTED OUTPUT
What the final answer should contain

Rules: Preserve intent. Add explicit "think step by step" reasoning instructions. Break complex problems into sequential stages. Return ONLY the improved prompt.`,

      FewShot: `You are an expert prompt engineer. Rewrite the user's raw prompt using the Few-Shot framework.

Structure the output with:
## TASK
Clear description of what needs to be done

## EXAMPLES
2-3 labeled examples showing the expected input→output pattern:

**Example 1:**
Input: [example input]
Output: [example output]

**Example 2:**
Input: [example input]
Output: [example output]

## YOUR TURN
The actual request to process

Rules: Preserve intent. Create realistic, relevant examples that demonstrate the desired pattern. Return ONLY the improved prompt.`,
    };

    const systemPrompt = systemPrompts[framework];
    if (!systemPrompt) return null;

    try {
      const response = await this.llmClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        { temperature: 0.3, maxTokens: 1024 }
      );

      if (response.content && response.content.length > 50) {
        return response.content;
      }
      return null;
    } catch {
      return null;
    }
  }
}
