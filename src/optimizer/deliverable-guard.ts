/**
 * DeliverableGuard — Extract and lock deliverable type from user prompts.
 *
 * Uses verb/keyword heuristics (no LLM call) to classify prompts into
 * deliverable types (code, research, analysis, documentation) and validates
 * that optimized prompts preserve the original deliverable type.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5
 */

// ─── Types ──────────────────────────────────────────────────────

export type DeliverableType = 'code' | 'research' | 'analysis' | 'documentation';

export interface DeliverableClassification {
  type: DeliverableType;
  confidence: number; // 0-1
  originalVerb: string; // "build", "create", "explain", etc.
}

// ─── Verb/Keyword Mappings ──────────────────────────────────────

interface VerbMapping {
  verbs: string[];
  keywords: string[];
}

const DELIVERABLE_VERBS: Record<DeliverableType, VerbMapping> = {
  code: {
    verbs: [
      'build',
      'create',
      'implement',
      'develop',
      'code',
      'deploy',
      'scaffold',
      'refactor',
      'fix',
      'debug',
      'program',
      'construct',
      'engineer',
      'compile',
      'generate',
      'write',
    ],
    keywords: [
      'webapp',
      'web app',
      'api',
      'endpoint',
      'function',
      'class',
      'component',
      'module',
      'service',
      'server',
      'application',
      'app',
      'frontend',
      'backend',
      'database',
      'microservice',
      'cli',
      'script',
      'bot',
      'plugin',
      'library',
      'package',
      'crud',
      'rest',
      'graphql',
    ],
  },
  research: {
    verbs: [
      'research',
      'investigate',
      'explore',
      'study',
      'survey',
      'discover',
      'find out',
      'look into',
    ],
    keywords: [
      'literature',
      'papers',
      'findings',
      'hypothesis',
      'experiment',
      'methodology',
      'field',
      'state of the art',
      'prior work',
      'publications',
    ],
  },
  analysis: {
    verbs: [
      'analyze',
      'analyse',
      'evaluate',
      'assess',
      'compare',
      'benchmark',
      'profile',
      'audit',
      'review',
      'measure',
      'inspect',
    ],
    keywords: [
      'performance',
      'metrics',
      'tradeoffs',
      'trade-offs',
      'pros and cons',
      'comparison',
      'strengths',
      'weaknesses',
      'bottleneck',
      'optimization',
      'report',
    ],
  },
  documentation: {
    verbs: [
      'document',
      'explain',
      'describe',
      'summarize',
      'summarise',
      'outline',
      'detail',
      'clarify',
      'elaborate',
      'illustrate',
    ],
    keywords: [
      'guide',
      'tutorial',
      'documentation',
      'readme',
      'docs',
      'manual',
      'instructions',
      'how-to',
      'walkthrough',
      'reference',
      'overview',
    ],
  },
};

/**
 * Contextual keywords that disambiguate certain verbs.
 * For example, "write" alone is ambiguous but "write an API" → code,
 * "write documentation" → documentation.
 */
const CODE_CONTEXT_KEYWORDS = [
  'app',
  'application',
  'api',
  'server',
  'function',
  'component',
  'service',
  'endpoint',
  'program',
  'script',
  'code',
  'class',
  'module',
  'bot',
  'cli',
  'tool',
];

const DOCUMENTATION_CONTEXT_KEYWORDS = [
  'docs',
  'documentation',
  'guide',
  'tutorial',
  'readme',
  'manual',
  'how-to',
  'instructions',
  'explanation',
];

/**
 * Verbs that are ambiguous and need context-based disambiguation.
 * When these verbs appear with documentation context keywords,
 * they should lean towards documentation.
 */
const AMBIGUOUS_VERBS = ['write', 'generate', 'create'];

// ─── DeliverableGuard ───────────────────────────────────────────

export class DeliverableGuard {
  /**
   * Extract and lock the deliverable type from a user prompt.
   * Uses verb/keyword heuristics (cheap — no LLM call needed).
   *
   * Edge cases:
   * - Empty input → returns 'code' with confidence 0
   * - Unclassifiable → returns best guess based on partial matches
   */
  classify(prompt: string): DeliverableClassification {
    // Edge case: empty or whitespace-only input
    if (!prompt || prompt.trim().length === 0) {
      return { type: 'code', confidence: 0, originalVerb: '' };
    }

    const normalized = prompt.toLowerCase().trim();
    const scores: Record<DeliverableType, { score: number; matchedVerb: string }> = {
      code: { score: 0, matchedVerb: '' },
      research: { score: 0, matchedVerb: '' },
      analysis: { score: 0, matchedVerb: '' },
      documentation: { score: 0, matchedVerb: '' },
    };

    // Score each deliverable type
    for (const [type, mapping] of Object.entries(DELIVERABLE_VERBS) as [DeliverableType, VerbMapping][]) {
      // Check verbs (higher weight — verbs are primary signals)
      for (const verb of mapping.verbs) {
        if (this.containsVerb(normalized, verb)) {
          // Handle ambiguous verbs with context disambiguation
          if (type === 'code' && AMBIGUOUS_VERBS.includes(verb)) {
            if (this.hasContextKeywords(normalized, DOCUMENTATION_CONTEXT_KEYWORDS)) {
              // "write documentation" / "create a guide" → documentation, not code
              scores['documentation'].score += 0.6;
              if (!scores['documentation'].matchedVerb) {
                scores['documentation'].matchedVerb = verb;
              }
              continue;
            }
            if (this.hasContextKeywords(normalized, CODE_CONTEXT_KEYWORDS)) {
              scores['code'].score += 0.8;
              if (!scores['code'].matchedVerb) {
                scores['code'].matchedVerb = verb;
              }
              continue;
            }
            // Ambiguous verb without context — give partial score to code
            scores['code'].score += 0.3;
            if (!scores['code'].matchedVerb) {
              scores['code'].matchedVerb = verb;
            }
            continue;
          }

          scores[type].score += 0.7;
          if (!scores[type].matchedVerb) {
            scores[type].matchedVerb = verb;
          }
        }
      }

      // Check keywords (lower weight — supporting context)
      for (const keyword of mapping.keywords) {
        if (normalized.includes(keyword)) {
          scores[type].score += 0.3;
        }
      }
    }

    // Find the highest-scoring type
    let bestType: DeliverableType = 'code';
    let bestScore = 0;
    let bestVerb = '';

    for (const [type, data] of Object.entries(scores) as [DeliverableType, { score: number; matchedVerb: string }][]) {
      if (data.score > bestScore) {
        bestScore = data.score;
        bestType = type;
        bestVerb = data.matchedVerb;
      }
    }

    // Calculate confidence (0-1) based on score and margin over runner-up
    const sortedScores = Object.values(scores)
      .map((s) => s.score)
      .sort((a, b) => b - a);
    const margin = sortedScores.length > 1 ? (sortedScores[0]! - sortedScores[1]!) : sortedScores[0]!;
    const confidence = Math.min(1, bestScore > 0 ? 0.5 + margin * 0.3 : 0);

    // If nothing matched at all, return 'code' as default with low confidence
    if (bestScore === 0) {
      return { type: 'code', confidence: 0.1, originalVerb: '' };
    }

    return {
      type: bestType,
      confidence: Math.round(confidence * 100) / 100,
      originalVerb: bestVerb,
    };
  }

  /**
   * Validate that an optimized prompt still targets the same deliverable type.
   * Returns true if preserved, false if corrupted.
   */
  validate(original: DeliverableClassification, optimizedPrompt: string): boolean {
    if (!optimizedPrompt || optimizedPrompt.trim().length === 0) {
      return false;
    }

    const optimizedClassification = this.classify(optimizedPrompt);

    // The optimized prompt must still classify as the same deliverable type
    return optimizedClassification.type === original.type;
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Check if the text contains a verb as a word boundary match.
   * Handles multi-word verbs (e.g., "find out", "look into").
   */
  private containsVerb(text: string, verb: string): boolean {
    // For multi-word verbs, simple includes is sufficient
    if (verb.includes(' ')) {
      return text.includes(verb);
    }
    // For single-word verbs, use word boundary matching
    const pattern = new RegExp(`\\b${verb}(?:s|ed|ing)?\\b`, 'i');
    return pattern.test(text);
  }

  /**
   * Check if the text contains any of the given context keywords.
   */
  private hasContextKeywords(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
  }
}
